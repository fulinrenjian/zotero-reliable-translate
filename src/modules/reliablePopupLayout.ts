import {
  clampPopupRect,
  movePopupRect,
  normalizeWheelDelta,
  resizePopupRect,
  type PopupRect,
  type ResizeEdge,
} from "../utils/reliablePopupGeometry";

export const DEFAULT_POPUP_WIDTH = 420;
export const DEFAULT_POPUP_HEIGHT = 360;
const MIN_WIDTH = 280;
const MIN_HEIGHT = 250;
const MARGIN = 8;

type StyleValues = Partial<CSSStyleDeclaration>;
type Options = {
  width?: number;
  height?: number;
  moveHandle?: HTMLElement;
  onResize?: (width: number, height: number) => void;
};

/** Layout is confined to this native reader popup, including its wrapper chain. */
export function createPopupLayout(
  popup: HTMLDivElement,
  panel: HTMLDivElement,
  text: HTMLTextAreaElement,
  options: Options,
) {
  const doc = popup.ownerDocument;
  const win = doc.defaultView;
  const savedStyles = new Map<HTMLElement, Map<string, string>>();
  const cleanup: Array<() => void> = [];
  const handles: HTMLDivElement[] = [];
  let disposed = false;
  let pendingFrame: number | undefined;
  let movedPosition: { left: number; top: number } | undefined;
  let drag:
    | {
        operation: ResizeEdge | "move";
        pointerId: number;
        x: number;
        y: number;
        start: PopupRect;
        handle: HTMLElement;
        changed: boolean;
      }
    | undefined;

  function styles(element: HTMLElement, values: StyleValues) {
    let original = savedStyles.get(element);
    if (!original) savedStyles.set(element, (original = new Map()));
    for (const [key, value] of Object.entries(values)) {
      const style = element.style as unknown as Record<string, string>;
      if (!original.has(key)) original.set(key, style[key] || "");
      if (style[key] !== value) style[key] = value as string;
    }
  }

  function listen(
    target: EventTarget,
    type: string,
    listener: EventListener,
    options?: AddEventListenerOptions | boolean,
  ) {
    target.addEventListener(type, listener, options);
    cleanup.push(() => target.removeEventListener(type, listener, options));
  }

  function scale() {
    const rect = popup.getBoundingClientRect();
    return {
      x: popup.offsetWidth > 0 ? rect.width / popup.offsetWidth || 1 : 1,
      y: popup.offsetHeight > 0 ? rect.height / popup.offsetHeight || 1 : 1,
    };
  }

  function bounds() {
    const width = doc.documentElement.clientWidth || doc.body.clientWidth;
    const height = doc.documentElement.clientHeight || doc.body.clientHeight;
    const parent = popup.closest?.(".primary-view, .secondary-view");
    const rect = parent?.getBoundingClientRect();
    const left = rect ? Math.max(0, rect.left) : 0;
    const top = rect ? Math.max(0, rect.top) : 0;
    const right = rect ? Math.min(width, rect.right) : width;
    const bottom = rect ? Math.min(height, rect.bottom) : height;
    return {
      left,
      top,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top),
    };
  }

  function localRect(): PopupRect {
    const rect = popup.getBoundingClientRect();
    const area = bounds();
    return {
      left: rect.left - area.left,
      top: rect.top - area.top,
      width: rect.width,
      height: rect.height,
    };
  }

  function limits() {
    const zoom = scale();
    // Native Add-to-Note, dictionary audio and save feedback can add fixed rows.
    const chromeHeight = Math.max(
      0,
      popup.getBoundingClientRect().height -
        text.getBoundingClientRect().height,
    );
    return {
      minWidth: MIN_WIDTH * zoom.x,
      minHeight: Math.max(MIN_HEIGHT * zoom.y, chromeHeight + 48 * zoom.y),
      margin: MARGIN,
    };
  }

  function applyRect(rect: PopupRect) {
    const zoom = scale();
    const area = bounds();
    // Preserve the native transform: ViewPopup owns its translate(x, y) anchor.
    styles(popup, {
      width: `${rect.width / zoom.x}px`,
      height: `${rect.height / zoom.y}px`,
    });
    const current = popup.getBoundingClientRect();
    const dx = area.left + rect.left - current.left;
    const dy = area.top + rect.top - current.top;
    if (Math.abs(dx) > 0.1)
      styles(popup, { left: `${popup.offsetLeft + dx / zoom.x}px` });
    if (Math.abs(dy) > 0.1)
      styles(popup, { top: `${popup.offsetTop + dy / zoom.y}px` });
  }

  function fitToViewport() {
    if (disposed || !popup.isConnected || drag) return;
    const area = bounds();
    if (!area.width || !area.height) return;
    const rect = clampPopupRect(
      { ...localRect(), ...movedPosition },
      area,
      limits(),
    );
    applyRect(rect);
    if (movedPosition) movedPosition = { left: rect.left, top: rect.top };
  }

  function scheduleFit() {
    if (disposed || pendingFrame !== undefined) return;
    if (!win?.requestAnimationFrame) return fitToViewport();
    pendingFrame = win.requestAnimationFrame(() => {
      pendingFrame = undefined;
      fitToViewport();
    });
  }

  function remember() {
    if (!popup.isConnected) return;
    const zoom = scale();
    const rect = popup.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    options.onResize?.(
      Math.round(rect.width / zoom.x),
      Math.round(rect.height / zoom.y),
    );
  }

  function finishDrag() {
    const current = drag;
    if (!current) return;
    drag = undefined;
    if (current.operation === "move")
      styles(current.handle, { cursor: "grab" });
    try {
      if (current.handle.hasPointerCapture?.(current.pointerId))
        current.handle.releasePointerCapture(current.pointerId);
    } catch {
      /* The reader may have removed the captured node. */
    }
    fitToViewport();
    if (current.changed && current.operation !== "move") remember();
  }

  function onMove(event: Event) {
    const e = event as PointerEvent;
    if (!drag || e.pointerId !== drag.pointerId) return;
    e.preventDefault();
    e.stopPropagation();
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    const rect =
      drag.operation === "move"
        ? movePopupRect(drag.start, dx, dy, bounds(), limits())
        : resizePopupRect(
            drag.start,
            drag.operation,
            dx,
            dy,
            bounds(),
            limits(),
          );
    drag.changed ||=
      Math.abs(rect.left - drag.start.left) > 0.1 ||
      Math.abs(rect.top - drag.start.top) > 0.1 ||
      Math.abs(rect.width - drag.start.width) > 0.1 ||
      Math.abs(rect.height - drag.start.height) > 0.1;
    if (drag.operation === "move" || movedPosition)
      movedPosition = { left: rect.left, top: rect.top };
    applyRect(rect);
  }

  function onEnd(event: Event) {
    if (!drag || (event as PointerEvent).pointerId !== drag.pointerId) return;
    event.stopPropagation();
    finishDrag();
  }

  function beginDrag(
    operation: ResizeEdge | "move",
    handle: HTMLElement,
    e: PointerEvent,
  ) {
    if (disposed || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    finishDrag();
    fitToViewport();
    drag = {
      operation,
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      start: localRect(),
      handle,
      changed: false,
    };
    if (operation === "move") styles(handle, { cursor: "grabbing" });
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      /* Document listeners provide a fallback. */
    }
  }

  const chain: HTMLElement[] = [];
  for (
    let parent = panel.parentElement;
    parent && parent !== popup;
    parent = parent.parentElement
  )
    chain.push(parent);
  styles(popup, {
    display: "flex",
    flexDirection: "column",
    boxSizing: "border-box",
    minWidth: "0",
    minHeight: "0",
    maxWidth: "none",
    maxHeight: "none",
    overflow: "visible",
  });
  for (const element of [...chain, panel]) {
    styles(element, {
      display: "flex",
      flexDirection: "column",
      flex: "1 1 auto",
      minWidth: "0",
      minHeight: "0",
      maxHeight: "none",
      overflow: "hidden",
    });
  }
  for (const child of Array.from(popup.children) as HTMLElement[]) {
    if (child !== panel && !chain.includes(child))
      styles(child, { flexShrink: "0" });
  }
  styles(text, {
    flex: "1 1 0",
    width: "100%",
    height: "auto",
    minWidth: "0",
    minHeight: "0",
    maxHeight: "none",
    resize: "none",
    overflowX: "hidden",
    overflowY: "auto",
    overscrollBehavior: "contain",
    scrollbarWidth: "auto",
    scrollbarGutter: "stable",
  });
  for (const child of Array.from(panel.children) as HTMLElement[]) {
    if (child !== text) styles(child, { flexShrink: "0" });
  }

  const edgeStyles: Record<ResizeEdge, StyleValues> = {
    n: {
      top: "-4px",
      left: "10px",
      right: "10px",
      height: "8px",
      cursor: "ns-resize",
    },
    s: {
      bottom: "-4px",
      left: "10px",
      right: "10px",
      height: "8px",
      cursor: "ns-resize",
    },
    w: {
      left: "-4px",
      top: "10px",
      bottom: "10px",
      width: "8px",
      cursor: "ew-resize",
    },
    e: {
      right: "-4px",
      top: "10px",
      bottom: "10px",
      width: "8px",
      cursor: "ew-resize",
    },
    nw: {
      left: "-4px",
      top: "-4px",
      width: "14px",
      height: "14px",
      cursor: "nwse-resize",
    },
    ne: {
      right: "-4px",
      top: "-4px",
      width: "14px",
      height: "14px",
      cursor: "nesw-resize",
    },
    sw: {
      left: "-4px",
      bottom: "-4px",
      width: "14px",
      height: "14px",
      cursor: "nesw-resize",
    },
    se: {
      right: "-4px",
      bottom: "-4px",
      width: "14px",
      height: "14px",
      cursor: "nwse-resize",
    },
  };
  for (const edge of Object.keys(edgeStyles) as ResizeEdge[]) {
    const handle = doc.createElement("div");
    handle.dataset.reliableResize = edge;
    handle.title = "拖动边缘或角调整浮窗大小";
    handle.setAttribute("aria-label", `调整浮窗大小 ${edge}`);
    Object.assign(handle.style, {
      position: "absolute",
      zIndex: "2",
      touchAction: "none",
      userSelect: "none",
      ...edgeStyles[edge],
    });
    if (edge === "se") {
      const grip = doc.createElement("span");
      Object.assign(grip.style, {
        position: "absolute",
        right: "4px",
        bottom: "4px",
        width: "7px",
        height: "7px",
        borderRight: "2px solid #8c96a3",
        borderBottom: "2px solid #8c96a3",
        pointerEvents: "none",
      });
      handle.append(grip);
    }
    listen(handle, "pointerdown", (event) =>
      beginDrag(edge, handle, event as PointerEvent),
    );
    listen(handle, "lostpointercapture", onEnd);
    for (const type of ["mousedown", "mouseup", "click", "dblclick"])
      listen(handle, type, (event) => event.stopPropagation());
    popup.append(handle);
    handles.push(handle);
  }
  if (options.moveHandle) {
    const handle = options.moveHandle;
    styles(handle, { cursor: "grab", touchAction: "none", userSelect: "none" });
    listen(handle, "pointerdown", (event) =>
      beginDrag("move", handle, event as PointerEvent),
    );
    listen(handle, "lostpointercapture", onEnd);
    for (const type of ["mousedown", "mouseup", "click", "dblclick"])
      listen(handle, type, (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
  }
  listen(doc, "pointermove", onMove, true);
  listen(doc, "pointerup", onEnd, true);
  listen(doc, "pointercancel", onEnd, true);
  if (win) {
    listen(win, "blur", finishDrag);
    listen(win, "resize", scheduleFit);
  }

  // Preserve native wheel/touchpad scrolling, containing overscroll at both ends.
  listen(
    text,
    "wheel",
    (event) => {
      const e = event as WheelEvent;
      e.stopPropagation();
      const max = Math.max(0, text.scrollHeight - text.clientHeight);
      if (
        !max ||
        (e.deltaY < 0 && text.scrollTop <= 0) ||
        (e.deltaY > 0 && text.scrollTop >= max - 1)
      )
        e.preventDefault();
    },
    { passive: false },
  );
  listen(
    popup,
    "wheel",
    (event) => {
      const e = event as WheelEvent;
      e.stopPropagation();
      e.preventDefault();
      if (
        (e.target as Element)?.closest?.("button, select, input, a") ||
        e.ctrlKey ||
        e.metaKey
      )
        return;
      const computed = win?.getComputedStyle?.(text);
      const lineHeight = Number.parseFloat(computed?.lineHeight || "") || 20;
      const delta = normalizeWheelDelta(
        e.deltaY,
        e.deltaMode,
        lineHeight,
        text.clientHeight,
      );
      text.scrollTop = Math.min(
        Math.max(0, text.scrollHeight - text.clientHeight),
        Math.max(0, text.scrollTop + delta),
      );
    },
    { passive: false },
  );

  function setInitialSize(width: number, height: number) {
    const zoom = scale();
    const rect = localRect();
    applyRect(
      clampPopupRect(
        { ...rect, width: width * zoom.x, height: height * zoom.y },
        bounds(),
        limits(),
      ),
    );
    scheduleFit();
  }
  setInitialSize(
    Number.isFinite(options.width) && options.width! >= MIN_WIDTH
      ? options.width!
      : DEFAULT_POPUP_WIDTH,
    Number.isFinite(options.height) && options.height! >= MIN_HEIGHT
      ? options.height!
      : DEFAULT_POPUP_HEIGHT,
  );

  return {
    fitToViewport,
    scheduleFit,
    reset() {
      finishDrag();
      setInitialSize(DEFAULT_POPUP_WIDTH, DEFAULT_POPUP_HEIGHT);
      remember();
    },
    dispose() {
      if (disposed) return;
      finishDrag();
      disposed = true;
      if (pendingFrame !== undefined) win?.cancelAnimationFrame?.(pendingFrame);
      for (const remove of cleanup) remove();
      for (const handle of handles) handle.remove();
      for (const [element, original] of savedStyles)
        for (const [key, value] of original)
          (element.style as unknown as Record<string, string>)[key] = value;
    },
  };
}

/** Avoid resetting scroll/copy selection on status-only or streaming updates. */
export function updatePopupText(
  text: HTMLTextAreaElement,
  value: string,
  reset: boolean,
) {
  if (value === text.value && !reset) return;
  const oldValue = text.value;
  const oldTop = text.scrollTop;
  const oldLeft = text.scrollLeft;
  const oldMax = Math.max(0, text.scrollHeight - text.clientHeight);
  const atEnd = oldMax > 0 && oldTop >= oldMax - 2;
  const start = text.selectionStart;
  const end = text.selectionEnd;
  if (value !== oldValue) text.value = value;
  if (reset) {
    text.scrollTop = 0;
    text.scrollLeft = 0;
    return;
  }
  text.scrollTop =
    atEnd && value.startsWith(oldValue) ? text.scrollHeight : oldTop;
  text.scrollLeft = oldLeft;
  if (start !== end)
    text.setSelectionRange?.(
      Math.min(start, value.length),
      Math.min(end, value.length),
    );
}
