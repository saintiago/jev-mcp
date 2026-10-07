const FIXED_ORIGIN = 'https://api.typesafe.ai';
const FIXED_PATH = '/v1/systemone';
const fixtureOrigin = process.env.JEV_TEST_PROVIDER_ORIGIN;
const nativeFetch = globalThis.fetch;

globalThis.fetch = (input, init) => {
  const destination = new URL(
    typeof input === 'string' || input instanceof URL
      ? String(input)
      : input.url,
  );
  if (
    destination.origin !== FIXED_ORIGIN ||
    destination.pathname !== FIXED_PATH
  ) {
    throw new Error('unexpected fetch destination');
  }
  if (fixtureOrigin === undefined) {
    throw new Error('JEV_TEST_PROVIDER_ORIGIN is not set');
  }
  const fixture = new URL(
    destination.pathname + destination.search,
    fixtureOrigin,
  );
  return nativeFetch(fixture, init);
};
