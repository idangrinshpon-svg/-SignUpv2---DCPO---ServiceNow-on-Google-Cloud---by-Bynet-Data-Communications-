export default async (request, context) => {
  if (request.method === "POST") {
    return fetch(new URL("/.netlify/functions/gcp-login", request.url), {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: "manual"
    });
  }

  return context.next();
};

export const config = {
  path: "/login",
  method: "POST"
};
