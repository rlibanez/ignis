import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { transport } from "./transport.js";

let fetchMock,session=0;

beforeEach(() => {
  fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ok:true,mtime:1,size:0,etag:"a".repeat(64)}),
    text: async () => "",
    arrayBuffer: async () => new ArrayBuffer(0),
  }));
  globalThis.fetch = fetchMock;
  globalThis.window = {
    location: { origin: "http://localhost" },
    __currentVaultId: "v",
    __ignisAuth:{sessionId:String(++session)},
  };
});

afterEach(() => {
  delete globalThis.fetch;
  delete globalThis.window;
});

function lastInit() {
  return fetchMock.mock.calls.at(-1)[1];
}

describe("transport keepalive gating", () => {
  it("sets keepalive on a small write", async () => {
    await transport.writeFile("a.md", "hello", "utf-8");

    expect(lastInit().keepalive).toBe(true);
  });

  it("omits keepalive when the body exceeds the 64KB cap", async () => {
    await transport.writeFile("a.md", "x".repeat(70 * 1024), "utf-8");

    expect(lastInit().keepalive).toBeFalsy();
  });

  it("counts base64 inflation against the cap for binary writes", async () => {
    // 60KB of bytes inflates to ~80KB of base64, over the cap.
    await transport.writeFile("a.bin", new Uint8Array(60 * 1024));

    expect(lastInit().keepalive).toBeFalsy();
  });

  it("sets keepalive on a bodyless delete", async () => {
    await transport.unlink("a.md");

    expect(lastInit().keepalive).toBe(true);
  });

  it("does not set keepalive on a read", async () => {
    await transport.readFile("a.md", "utf8");

    expect(lastInit().keepalive).toBeUndefined();
  });
});

it("pins reads and writes to the opened UUID instead of a reusable directory name", async () => {
  window.__currentVaultUuid = "opened-uuid";
  await transport.writeFile("a.md", "hello", "utf-8");
  expect(JSON.parse(lastInit().body).vault).toBe("opened-uuid");
  await transport.readFile("a.md", "utf-8");
  expect(new URL(fetchMock.mock.calls.at(-1)[0]).searchParams.get("vault")).toBe("opened-uuid");
});

it('sends an explicit editor version and propagates conflicts without retrying',async()=>{
 const hash='b'.repeat(64);
 fetchMock.mockResolvedValueOnce({ok:false,status:409,json:async()=>({code:'CONTENT_CONFLICT'})});
 await expect(transport.writeEditorFile('n.md','draft',hash)).rejects.toMatchObject({code:'CONTENT_CONFLICT'});
 expect(JSON.parse(lastInit().body).expectedHash).toBe(hash);expect(fetchMock).toHaveBeenCalledTimes(1);
});
it('never sends a conditional editor save without a valid version',async()=>{
 for(const version of [undefined,null,'',false,'*'])await expect(transport.writeEditorFile('n.md','draft',version)).rejects.toThrow();
 expect(fetchMock).not.toHaveBeenCalled();
});
it('keeps ordinary plugin writes unconditional even after reads and protected editor saves',async()=>{
 await transport.readFile('n.md','utf8');await transport.writeEditorFile('n.md','editor','b'.repeat(64));
 await transport.writeFile('n.md','plugin');expect(JSON.parse(lastInit().body)).not.toHaveProperty('expectedHash');
});
it('propagates a lost editor response without automatic retry',async()=>{
 fetchMock.mockRejectedValueOnce(new Error('lost'));
 await expect(transport.writeEditorFile('n.md','draft','b'.repeat(64))).rejects.toMatchObject({code:'CONTENT_WRITE_UNCERTAIN',outcome:'uncertain'});expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('treats undecodable write acknowledgements as uncertain, without replay',async()=>{
 fetchMock.mockResolvedValueOnce({ok:true,json:async()=>{throw new Error('truncated');}});
 await expect(transport.writeFile('n.md','plugin')).rejects.toMatchObject({code:'CONTENT_WRITE_UNCERTAIN'});
 expect(fetchMock).toHaveBeenCalledTimes(1);
});
it('does not retry an ordinary plugin write when network delivery is unknown',async()=>{
 fetchMock.mockRejectedValueOnce(new TypeError('network failed'));
 await expect(transport.writeFile('n.md','plugin')).rejects.toMatchObject({code:'CONTENT_WRITE_UNCERTAIN',outcome:'uncertain'});
 expect(fetchMock).toHaveBeenCalledTimes(1);
});

it.each([408,500,502,503])('preserves writes with ambiguous HTTP %s instead of replaying',async status=>{
 fetchMock.mockResolvedValueOnce({ok:false,status,json:async()=>({error:'upstream failed'})});
 await expect(transport.writeFile('n.md','draft')).rejects.toMatchObject({code:'CONTENT_WRITE_UNCERTAIN'});
 expect(fetchMock).toHaveBeenCalledTimes(1);
});
it('keeps a definite pre-publication failure distinct from uncertainty',async()=>{
 fetchMock.mockResolvedValueOnce({ok:false,status:500,json:async()=>({error:'disk full',code:'ENOSPC',outcome:'failed'})});
 await expect(transport.writeFile('n.md','draft')).rejects.toMatchObject({code:'ENOSPC',outcome:'failed'});
});

it.each([{},null,{ok:false,mtime:1,size:1},{ok:true,mtime:null,size:1}])('does not acknowledge incomplete success payload %j',async payload=>{
 fetchMock.mockResolvedValueOnce({ok:true,json:async()=>payload});
 await expect(transport.writeFile('n.md','draft')).rejects.toMatchObject({code:'CONTENT_WRITE_UNCERTAIN'});
 expect(fetchMock).toHaveBeenCalledTimes(1);
});
