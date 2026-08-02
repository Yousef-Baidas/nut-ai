/**
 * Babel config for the SDK 54 fork (not present upstream).
 *
 * SDK 57 applies `babel-preset-expo` implicitly; SDK 54's tooling expects this
 * file to exist. Kept deliberately minimal — this is the stock Expo template.
 */
module.exports = function (api) {
  api.cache(true)
  return { presets: ['babel-preset-expo'] }
}
