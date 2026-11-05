import { it, expect, vi } from "vitest";
import {
  initWriteCoalescer,
  bufferWrite,
  enqueueWrite,
  enqueueMutation,
  snapshotBuffered,
  suspendCoalescer,
  _reset,
} from "./write-coalescer.js";
it("preserves queued and buffered writes for export while preventing their dispatch after lock", async () => {
  vi.useFakeTimers();
  _reset();
  try {
    const transport = { writeFile: vi.fn().mockResolvedValue({}) };
    initWriteCoalescer(transport);
    bufferWrite("boot.md", "buffered", "utf-8");
    const queued = enqueueWrite("queued.md", "queued", "utf-8");
    expect(
      snapshotBuffered()
        .map((x) => x.data)
        .sort(),
    ).toEqual(["buffered", "queued"]);
    suspendCoalescer();
    await expect(queued).rejects.toThrow("Session locked");
    await vi.advanceTimersByTimeAsync(5000);
    expect(transport.writeFile).not.toHaveBeenCalled();
    expect(snapshotBuffered()[0].data).toBe("buffered");
  } finally {
    _reset();
    vi.useRealTimers();
  }
});

it("does not dispatch a queued folder mutation after session lock", async () => {
  _reset();
  try {
    let release;
    const transport = {writeFile: vi.fn(() => new Promise(resolve => {release = resolve;}))};
    initWriteCoalescer(transport);
    const write = enqueueWrite("folder/note.md", "draft", "utf8");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const send = vi.fn();
    const mutation = enqueueMutation(["folder"], send);
    const rejected = expect(mutation).rejects.toThrow("Session locked");
    suspendCoalescer();
    release({mtime:1,size:5});
    await write;
    await rejected;
    expect(send).not.toHaveBeenCalled();
  } finally { _reset(); }
});
