// Handles POST /login from GCP Marketplace (SSO flow).
// Reads the JWT and redirects to login.html with token as query param.

const redirect = (location) => ({
  statusCode: 303,
  headers: {
    Location: location,
    'Cache-Control': 'no-store'
  },
  body: ''
});

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  try {
    const params = new URLSearchParams(event.body || '');
    const token  = params.get('x-gcp-marketplace-token') || '';
    if (!token) {
      return redirect('/login.html?error=missing_token');
    }
    const parts = token.split('.');
    if (parts.length !== 3) {
      return redirect('/login.html?error=invalid_token');
    }
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
    if (payload.exp && Date.now() / 1000 > payload.exp) {
      return redirect('/login.html?error=token_expired');
    }
    return redirect(`/login.html?x-gcp-marketplace-token=${encodeURIComponent(token)}`);
  } catch (err) {
    return redirect('/login.html?error=server_error');
  }
};
