// Handles POST /login from GCP Marketplace (SSO flow).
// Reads the JWT and redirects to login.html with token as query param.

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 302, headers: { Location: '/login.html' }, body: '' };
  }
  try {
    const params = new URLSearchParams(event.body || '');
    const token  = params.get('x-gcp-marketplace-token') || '';
    if (!token) {
      return { statusCode: 302, headers: { Location: '/login.html' }, body: '' };
    }
    return {
      statusCode: 302,
      headers: { Location: `/login.html?x-gcp-marketplace-token=${encodeURIComponent(token)}` },
      body: ''
    };
  } catch (err) {
    return { statusCode: 302, headers: { Location: '/login.html' }, body: '' };
  }
};
