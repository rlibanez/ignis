import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
export const contentHash = value => bytesToHex(sha256(typeof value === "string" ? new TextEncoder().encode(value) : value));
