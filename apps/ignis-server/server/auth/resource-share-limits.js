function readResourceShareLimits(env = process.env) {
  const value = env.IGNIS_SHARED_RESOURCE_MAX_FILE_MIB ?? "8";
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value) || Number(value) > 128)
    throw new Error("Invalid IGNIS_SHARED_RESOURCE_MAX_FILE_MIB; expected an integer from 1 to 128");
  const maxFileMiB = Number(value);
  const maxFileBytes = maxFileMiB * 1024 * 1024;
  return Object.freeze({ maxFileMiB, maxFileBytes, maxRequestBytes: Math.ceil(maxFileBytes / 3) * 4 + 65536 });
}
module.exports = { readResourceShareLimits };
