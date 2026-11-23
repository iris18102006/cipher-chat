# Render deployment

The repository includes a Render Docker service definition. It uses one web instance and a persistent disk mounted at `/data`; encrypted chat blobs are stored at `/data/blobs`.

Before launch, set secrets in the Render dashboard: `CIPHER_GIPHY_KEY` (optional), `CIPHER_ADMINS` (optional), and any image-check settings. Set a custom domain and verify HTTPS before inviting users. Keep a separate backup of `/data`; a persistent disk is not a backup. Test restore before launch.

Health check: `/healthz`.
