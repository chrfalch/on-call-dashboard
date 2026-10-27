// Expo SDK labels (`sdk-58`) and whether an item belongs only to unsupported SDKs.
// Pure functions only (no DOM), so it can be unit-tested with node.

const SDK_LABEL = /^sdk-(\d+)$/;
const version = (name) => Number(SDK_LABEL.exec(name)[1]);

export const isSdkLabel = (name) => SDK_LABEL.test(name);

// Newest first: `sdk-100` before `sdk-59`.
export const sdkLabels = (labels) =>
  [...new Set(labels.map((l) => l.name).filter(isSdkLabel))].sort((a, b) => version(b) - version(a));

export function isUnsupportedSdk(item, unsupported) {
  const sdks = item.labels.map((l) => l.name).filter(isSdkLabel);
  return sdks.length > 0 && sdks.every((name) => unsupported.has(name));
}

// The stored value is a JSON array of label names; anything else means nothing is unsupported.
export function parseUnsupportedSdks(raw) {
  try {
    const names = JSON.parse(raw);
    return new Set(Array.isArray(names) ? names.filter((n) => typeof n === 'string') : []);
  } catch {
    return new Set();
  }
}
