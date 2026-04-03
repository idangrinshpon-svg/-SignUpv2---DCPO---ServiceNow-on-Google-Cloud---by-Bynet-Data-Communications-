const { buildVerifiedParams, extractRequestParams, verifyMarketplaceToken } = require('./_shared/marketplace');

const redirect = (location) => ({
  statusCode: 303,
  headers: {
    Location: location,
    'Cache-Control': 'no-store',
  },
  body: '',
});

const reject = (message) => redirect(`/login.html?error=${encodeURIComponent(message)}`);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { demo, token } = extractRequestParams(event);
    if (!token) return reject('missing_token');

    const result = await verifyMarketplaceToken(event, token, { demo });
    if (!result.ok) {
      return reject(result.error === 'token_expired' ? 'token_expired' : 'invalid_token');
    }

    const params = buildVerifiedParams(result.payload);
    params.set('source', demo ? 'demo' : 'gcp');
    return redirect(`/login.html?${params.toString()}`);
  } catch (err) {
    console.error('gcp-login error:', err);
    return reject('server_error');
  }
};
