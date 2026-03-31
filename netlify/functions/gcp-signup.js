// Netlify serverless function — handles the POST from Google Cloud Marketplace.
// GCP sends:  POST /signup  with  x-gcp-marketplace-token=<JWT>  in the body.
// This function reads the JWT, validates the basics, then redirects the user
// to signup.html with the token as a query-param so the page can read it.

const redirect = (location) => ({
  // Explicitly convert POST handling into a follow-up GET.
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
    // Parse the URL-encoded body GCP sends
    const params = new URLSearchParams(event.body || '');
    const token  = params.get('x-gcp-marketplace-token') || '';

    if (!token) return redirect('/signup.html?error=missing_token');

    // Basic JWT structure check (full crypto verification happens on your backend
    // when you call the Partner Procurement API)
    const parts = token.split('.');
    if (parts.length !== 3) return redirect('/signup.html?error=invalid_token');

    // Decode payload (no signature verification here — browser-safe redirect only)
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));

    // Ensure token is not expired
    if (payload.exp && Date.now() / 1000 > payload.exp) {
      return redirect('/signup.html?error=token_expired');
    }

    // Redirect to signup page with the token — page JS will read it and
    // display the GCP-verified UI and pre-fill known fields.
    const redirectUrl = `/signup.html?x-gcp-marketplace-token=${encodeURIComponent(token)}`;
    return redirect(redirectUrl);

  } catch (err) {
    console.error('gcp-signup error:', err);
    return redirect('/signup.html?error=server_error');
  }
};
