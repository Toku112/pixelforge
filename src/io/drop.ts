/**
 * Drag-and-drop file opening: dropping image files anywhere on `target` opens them.
 * `onActive` reports when files are being dragged over (to show a drop highlight).
 */
export function installFileDrop(
  target: HTMLElement,
  onFiles: (files: File[]) => void,
  onActive?: (active: boolean) => void,
): () => void {
  let depth = 0;
  const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');

  const enter = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (depth++ === 0) onActive?.(true);
  };
  const over = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); // allow dropping
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  };
  const leave = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    if (--depth <= 0) {
      depth = 0;
      onActive?.(false);
    }
  };
  const drop = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); // stop the browser from navigating to the file
    depth = 0;
    onActive?.(false);
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length > 0) onFiles(files);
  };

  target.addEventListener('dragenter', enter);
  target.addEventListener('dragover', over);
  target.addEventListener('dragleave', leave);
  target.addEventListener('drop', drop);
  return () => {
    target.removeEventListener('dragenter', enter);
    target.removeEventListener('dragover', over);
    target.removeEventListener('dragleave', leave);
    target.removeEventListener('drop', drop);
  };
}
