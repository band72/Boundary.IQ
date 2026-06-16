/**
 * asyncHandler — wraps an async Express route/middleware function so that
 * any rejected promise is forwarded to next(err) instead of becoming an
 * unhandled rejection that crashes the process.
 *
 * Usage (before):
 *   router.get('/thing', async (req, res) => {
 *     try { ... } catch (err) { res.status(500).json({ error: err.message }); }
 *   });
 *
 * Usage (after):
 *   router.get('/thing', asyncHandler(async (req, res) => {
 *     // throw here → goes to the global error handler in index.js
 *   }));
 */
export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
