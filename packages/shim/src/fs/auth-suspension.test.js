import { it, expect, vi } from "vitest";
import {
  initWriteCoalescer,
  bufferWrite,
  enqueueWrite,
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
