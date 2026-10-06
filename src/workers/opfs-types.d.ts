// OPFS synchronous access handles are only declared in TypeScript's WebWorker
// library, while our worker modules compile with the DOM library. These are the
// parts the swap worker uses (https://fs.spec.whatwg.org/#api-filesystemsyncaccesshandle).

interface FileSystemReadWriteOptions {
  at?: number;
}

interface FileSystemSyncAccessHandle {
  read(buffer: AllowSharedBufferSource, options?: FileSystemReadWriteOptions): number;
  write(buffer: AllowSharedBufferSource, options?: FileSystemReadWriteOptions): number;
  truncate(newSize: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}

interface FileSystemFileHandle {
  createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle>;
}
