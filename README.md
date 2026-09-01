# PJ's Oracle Atelier

Tarot reading web app for Netlify deployment.

## Netlify

- Publish directory: `outputs`
- Functions directory: `netlify/functions`
- Required environment variable: `OPENAI_API_KEY`

Do not commit API keys.

## OpenAI API connection

The browser calls /.netlify/functions/generate-reading. The Netlify function
then calls the OpenAI Responses API with OPENAI_API_KEY from the server
environment, so the secret is never included in index.html.

1. Deploy the project root so Netlify reads netlify.toml.
2. In Netlify, add OPENAI_API_KEY under project environment variables.
3. Optionally set OPENAI_MODEL. The default is gpt-4.1-mini.
4. Trigger a new deploy after saving the variable.
5. Open /.netlify/functions/generate-reading on the deployed domain. A
   successful health check returns an ok response.

Use tarot-netlify-api-source.zip for an API-enabled source deployment. The
older tarot-netlify-upload.zip is a static-only package and cannot execute
server functions by itself.
