const BACKGROUND_URL = 'https://esm-forms.netlify.app/.netlify/functions/setup-run-background';

exports.handler = async (event) => {
  const hookSecret = event.headers['x-hook-secret'];
  if (hookSecret) {
    return { statusCode: 200, headers: { 'X-Hook-Secret': hookSecret }, body: '' };
  }

  fetch(BACKGROUND_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: event.body,
  }).catch(() => {});

  return { statusCode: 200, body: JSON.stringify({ queued: true }) };
};
