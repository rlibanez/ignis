import { it, expect } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createRequestLimits } = require("./request-limits");
it("bounds account attempts across IPs and expires limits without permanent lockout", () => {
  let at = 0;
  const limits = createRequestLimits({ now: () => at });
  for (let i = 0; i < 10; i++)
    expect(limits.login(`ip-${i}`, "account")).toBe(true);
  expect(limits.login("another-ip", "account")).toBe(false);
  at = 15 * 60000;
  expect(limits.login("another-ip", "account")).toBe(true);
});
it("rejects new buckets on capacity exhaustion and recovers after expiry", () => {
  let at = 0;
  const limits = createRequestLimits({ now: () => at, capacity: 3 });
  expect(limits.login("ip", "account")).toBe(true);
  expect(limits.login("other", "different")).toBe(false);
  at = 15 * 60000;
  expect(limits.login("other", "different")).toBe(true);
});
it("limits global login pressure even when both IP and account vary", () => {
  const limits = createRequestLimits();
  for (let i = 0; i < 60; i++)
    expect(limits.login(`ip-${i}`, `user-${i}`)).toBe(true);
  expect(limits.login("new-ip", "new-user")).toBe(false);
});
it("bounds setup globally across IPs and recovers after the setup window", () => {
  let at = 0;
  const limits = createRequestLimits({ now: () => at });
  for (let i = 0; i < 20; i++) expect(limits.setup(`ip-${i}`)).toBe(true);
  expect(limits.setup("another")).toBe(false);
  at = 15 * 60000;
  expect(limits.setup("another")).toBe(true);
});

it("bounds user creation per administrator and globally, then recovers", () => {
  let at = 0;
  const limits = createRequestLimits({ now: () => at });
  for (const actor of ["a", "b", "c"]) {
    for (let i = 0; i < 10; i++) expect(limits.createUser(actor)).toBe(true);
    expect(limits.createUser(actor)).toBe(false);
  }
  expect(limits.createUser("d")).toBe(false);
  at = 60000;
  expect(limits.createUser("a")).toBe(true);
});

it("separates assets and auth reads from sensitive request budgets and expires them", () => {
  let at = 0;
  const limits = createRequestLimits({ now: () => at });
  for (let i = 0; i < 600; i++) expect(limits.staticRequest("ip")).toBe(true);
  expect(limits.staticRequest("ip")).toBe(false);
  for (let i = 0; i < 300; i++) expect(limits.authRead("ip")).toBe(true);
  expect(limits.authRead("ip")).toBe(false);
  expect(limits.publicRequest("ip")).toBe(true);
  for (let i = 0; i < 10; i++) expect(limits.oidcStart("ip")).toBe(true);
  expect(limits.oidcStart("ip")).toBe(false);
  at = 60000;
  expect(limits.staticRequest("ip")).toBe(true);
  expect(limits.authRead("ip")).toBe(true);
  expect(limits.oidcStart("ip")).toBe(false);
});
it('bounds vault creation per account and globally and recovers after a minute',()=>{
 let now=0;const limits=createRequestLimits({now:()=>now});
 for(let i=0;i<10;i++)expect(limits.vaultCreation('one')).toBe(true);
 expect(limits.vaultCreation('one')).toBe(false);expect(limits.vaultCreation('two')).toBe(true);
 now=60001;expect(limits.vaultCreation('one')).toBe(true);
 const global=createRequestLimits();for(let i=0;i<60;i++)expect(global.vaultCreation(String(i))).toBe(true);
 expect(global.vaultCreation('next')).toBe(false);
});

it('reports the remaining login wait, rounds up seconds and never extends it on rejection',()=>{
 let at=0;const limits=createRequestLimits({now:()=>at});
 for(let i=0;i<10;i++)expect(limits.checkLogin('one-ip','one-account').allowed).toBe(true);
 expect(limits.checkLogin('one-ip','one-account')).toEqual({allowed:false,retryAfterSeconds:900});
 at=123456;expect(limits.checkLogin('one-ip','one-account').retryAfterSeconds).toBe(777);
 at=899999;expect(limits.checkLogin('one-ip','one-account').retryAfterSeconds).toBe(1);
 at=900000;expect(limits.checkLogin('one-ip','one-account')).toEqual({allowed:true,retryAfterSeconds:0});
});
it('uses the longest blocking window when global and account budgets are both exhausted',()=>{
 let at=0;const limits=createRequestLimits({now:()=>at});
 for(let i=0;i<60;i++)expect(limits.login('ip-'+i,i<10?'target':'account-'+i)).toBe(true);
 at=1500;expect(limits.checkLogin('fresh-ip','target').retryAfterSeconds).toBe(899);
 expect(limits.checkLogin('fresh-ip','fresh-account').retryAfterSeconds).toBe(59);
 at=60000;expect(limits.checkLogin('fresh-ip','fresh-account').allowed).toBe(true);
});
it('uses the later expiry when IP and account windows started at different times',()=>{
 let at=0;const limits=createRequestLimits({now:()=>at});limits.login('target-ip','initial');
 at=120000;
 for(let i=0;i<9;i++)expect(limits.login('target-ip','other-'+i)).toBe(true);
 for(let i=0;i<10;i++)expect(limits.login('different-'+i,'target-account')).toBe(true);
 expect(limits.checkLogin('target-ip','target-account').retryAfterSeconds).toBe(900);
 at=900000;expect(limits.checkLogin('target-ip','target-account').retryAfterSeconds).toBe(120);
});
it('reports when enough unrelated counters expire to recover capacity',()=>{
 let at=0;const limits=createRequestLimits({now:()=>at,capacity:3});limits.login('one','first');
 expect(limits.checkLogin('two','second').retryAfterSeconds).toBe(900);
 at=60000;expect(limits.checkLogin('two','second').retryAfterSeconds).toBe(840);
 at=900000;expect(limits.checkLogin('two','second').allowed).toBe(true);
});
it('does not let rejected attempts from one IP exhaust the global login budget for another user',()=>{
 const limits=createRequestLimits();
 for(let i=0;i<10;i++)expect(limits.login('attacker-ip','guess-'+i)).toBe(true);
 for(let i=10;i<100;i++)expect(limits.login('attacker-ip','guess-'+i)).toBe(false);
 expect(limits.checkLogin('legitimate-ip','legitimate-account').allowed).toBe(true);
});
