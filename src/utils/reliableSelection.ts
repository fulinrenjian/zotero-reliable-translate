/** A small task shape that does not depend on Zotero or the DOM. */
export interface SelectionTask {
  id: string;
  raw: string;
  itemId?: number;
  status: "waiting" | "processing" | "success" | "fail" | "failed";
}

export type SelectionReaderKey = string | number | object;

export interface SelectionBinding<
  Task extends SelectionTask,
  Popup extends object,
> {
  readonly readerKey: SelectionReaderKey;
  readonly taskId: string;
  /** Snapshot of the selected text; a task may later be edited or retried. */
  readonly raw: string;
  readonly itemId: number | undefined;
  readonly task: Task;
  readonly popup: Popup;
  readonly generation: number;
}

interface ReaderSelection<Task extends SelectionTask, Popup extends object> {
  task: Task;
  raw: string;
  itemId: number | undefined;
  binding?: SelectionBinding<Task, Popup>;
}

/** Normalize harmless PDF whitespace differences without dropping punctuation. */
export function normalizeSelectionText(raw: string): string {
  return (
    raw
      .normalize("NFKC")
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001F\u007F-\u009F]/gu, " ")
      .replace(/\s+/gu, " ")
      .trim()
  );
}

/** Failed and not-yet-started tasks must be allowed to start a new attempt. */
export function canReuseSelectionTask(
  task: SelectionTask | undefined,
): boolean {
  return task?.status === "processing" || task?.status === "success";
}

function defaultPopupIsOpen(popup: object): boolean {
  const lifecycle = popup as { isConnected?: boolean; closed?: boolean };
  return lifecycle.isConnected !== false && lifecycle.closed !== true;
}

/**
 * Owns the current selection separately for each reader. A popup always belongs
 * to exactly one current selection. Closing its UI keeps the current task for
 * reselection, while releasing the reader drops both the task and UI references.
 *
 * Call closePopup when the popup is dismissed and releaseReader on reader close.
 * DOM nodes with isConnected=false and windows with closed=true are also rejected.
 */
export class ReliableSelectionBindings<
  Task extends SelectionTask,
  Popup extends object = object,
> {
  private readonly readers = new Map<
    SelectionReaderKey,
    ReaderSelection<Task, Popup>
  >();
  private popups = new WeakMap<Popup, SelectionBinding<Task, Popup>>();
  private generation = 0;
  private readonly popupIsOpen: (popup: Popup) => boolean;

  constructor(popupIsOpen: (popup: Popup) => boolean = defaultPopupIsOpen) {
    this.popupIsOpen = popupIsOpen;
  }

  bind(
    readerKey: SelectionReaderKey,
    task: Task,
    popup: Popup,
  ): SelectionBinding<Task, Popup> {
    // Reader state can outlive a dismissed popup, but never its UI binding.
    this.detach(this.readers.get(readerKey)?.binding);

    // A physical popup reused by a different reader loses its former owner.
    const formerOwner = this.popups.get(popup);
    if (formerOwner) {
      this.readers.delete(formerOwner.readerKey);
      this.detach(formerOwner);
    }

    const binding: SelectionBinding<Task, Popup> = {
      readerKey,
      taskId: task.id,
      raw: normalizeSelectionText(task.raw),
      itemId: task.itemId,
      task,
      popup,
      generation: ++this.generation,
    };
    this.readers.set(readerKey, {
      task,
      raw: binding.raw,
      itemId: binding.itemId,
      binding,
    });
    this.popups.set(popup, binding);
    return binding;
  }

  getForPopup(popup: Popup): SelectionBinding<Task, Popup> | undefined {
    const binding = this.popups.get(popup);
    if (!binding || this.readers.get(binding.readerKey)?.binding !== binding) {
      return undefined;
    }
    if (!this.popupIsOpen(popup)) {
      this.closePopup(popup);
      return undefined;
    }
    return binding;
  }

  /** Returns even failed/waiting tasks, so the caller can explicitly retry. */
  findSame(
    readerKey: SelectionReaderKey,
    raw: string,
    itemId?: number,
  ): Task | undefined {
    const selection = this.readers.get(readerKey);
    return selection?.raw === normalizeSelectionText(raw) &&
      selection.itemId === itemId
      ? selection.task
      : undefined;
  }

  /** The reader's current task, also while its popup is temporarily dismissed. */
  getCurrentTask(readerKey: SelectionReaderKey): Task | undefined {
    return this.readers.get(readerKey)?.task;
  }

  /**
   * Async completion must pass this guard immediately before writing to the UI.
   * A captured generation additionally protects reuse of the same task and node.
   */
  canRender(taskId: string, popup: Popup, generation?: number): boolean {
    const binding = this.getForPopup(popup);
    return (
      binding?.taskId === taskId &&
      (generation === undefined || binding.generation === generation)
    );
  }

  closePopup(popup: Popup): void {
    const binding = this.popups.get(popup);
    if (!binding) return;
    this.detach(binding);
    const selection = this.readers.get(binding.readerKey);
    if (selection?.binding === binding) {
      selection.binding = undefined;
    }
  }

  releaseReader(readerKey: SelectionReaderKey): void {
    this.detach(this.readers.get(readerKey)?.binding);
    this.readers.delete(readerKey);
  }

  clear(): void {
    this.readers.clear();
    this.popups = new WeakMap<Popup, SelectionBinding<Task, Popup>>();
  }

  private detach(binding: SelectionBinding<Task, Popup> | undefined): void {
    if (binding && this.popups.get(binding.popup) === binding) {
      this.popups.delete(binding.popup);
    }
  }
}
