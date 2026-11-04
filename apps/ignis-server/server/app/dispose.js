// Best-effort cleanup never skips later resources after one failure.
async function disposeAll(disposers) {
  const errors = [];
  for (const dispose of disposers.splice(0).reverse()) {
    try { await dispose(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors,'Application cleanup failed');
}
module.exports = {disposeAll};
