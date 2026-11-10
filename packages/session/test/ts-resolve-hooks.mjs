export async function resolve(specifier, context, next) {
  if (specifier.startsWith(".") && specifier.endsWith(".js")) {
    try {
      return await next(specifier.replace(/\.js$/, ".ts"), context);
    } catch {
      // Fall through to the specifier as written.
    }
  }
  return next(specifier, context);
}
