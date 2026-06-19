# LAN HTTPS for the Pi API (Caddy local CA + Pi-hole)

**Goal:** let the HTTPS PWA reach the Pi API over the **LAN** at full speed, without the browser's mixed-content block, and without depending on the Tailscale Funnel relay for at-home traffic.

**How:** a Caddy reverse proxy on the Pi terminates TLS using its **built-in local CA** (`tls internal`) for the name `pi.home.arpa`. You install Caddy's root CA on each reading device once (it then trusts every service behind this Caddy, now and future). Pi-hole resolves `pi.home.arpa` → the Pi's LAN IP. The Funnel stays as the off-LAN ("Remote") path; Caddy is an additional LAN-only door to the same `api:8080`.

```
phone (HTTPS PWA)  ──LAN──▶  https://pi.home.arpa:8443  (Pi-hole → 192.168.1.107)
                              └─▶ Caddy host:8443→:443  (TLS, local CA)  ──▶  api:8080
off-LAN (no Tailscale)        https://pajohn.tail8f51b4.ts.net  ──Funnel──▶ api:8080   (unchanged)
```

> Caddy runs on host port **8443** because Tailscale Funnel already holds the
> Pi's `:443` (it serves the Remote path). So the Local URL carries `:8443`.

No public domain, no Let's Encrypt, no internet required.

---

## One-time setup

### 1. Deploy Caddy on the Pi
```bash
cd ~/verreaux
git pull                                  # brings Caddyfile + the caddy compose service
docker compose up -d caddy                # pulls caddy:2-alpine, starts it on host :8443
docker compose ps                         # caddy should be Up, 0.0.0.0:8443->443
docker compose logs caddy | tail -20      # expect it serving pi.home.arpa; no errors
```
(Host port is **8443** because Tailscale Funnel holds the Pi's `:443`. If 8443 is ever taken too, change the compose port and the Local URL to match.)

### 2. Reserve the Pi's LAN IP
In the router's DHCP settings, reserve the Pi's current IP (e.g. `192.168.1.107`) to its MAC so it never changes. The Pi-hole record below points at this IP.

### 3. Pi-hole: local DNS record
Pi-hole admin → **Local DNS → DNS Records** → add:
```
Domain:  pi.home.arpa
IP:      192.168.1.107        # the reserved Pi IP
```
Devices must use Pi-hole as their resolver (normally already the case if the router hands out Pi-hole as DNS). Verify from a device on the LAN: `pi.home.arpa` should resolve to the Pi IP.

### 4. Export Caddy's root CA
Caddy generates its local CA on first run. With the bind mount it's on the Pi's host filesystem:
```bash
cp ~/verreaux/data/caddy/data/caddy/pki/authorities/local/root.crt ~/caddy-root.crt
# transfer ~/caddy-root.crt to each device (AirDrop / email / a file share / scp)
```
(If the path differs, find it: `find ~/verreaux/data/caddy -name root.crt`.)

### 5. Install + trust the root CA on each reading device
- **iOS:** open/AirDrop the `.crt` → Settings → *Profile Downloaded* → Install. **Then** Settings → General → About → **Certificate Trust Settings** → toggle the Caddy CA **on** (this second step is required, otherwise HTTPS still fails).
- **Android:** Settings → Security → Encryption & credentials → Install a certificate → **CA certificate** → pick the `.crt`.
- **macOS (if reading on a Mac):** double-click → Keychain Access → System → set the cert to **Always Trust**.

### 6. Point the PWA at the Local endpoint
PWA → Settings → **Local** = `https://pi.home.arpa:8443` → flip the toggle to **Local** when on home WiFi (leave on **Remote** when away).

---

## Verify
On a device that's on the LAN, using Pi-hole DNS, with the CA installed, open in the browser:
```
https://pi.home.arpa:8443/runs/x
```
Expected: a clean **404 JSON** (`{"error":"run not found"}`) with **no certificate warning**. That proves: name resolves → Caddy TLS trusted → proxy to api works. Then in the PWA, Sync now / a download over **Local** should run at LAN speed.

## Notes
- **CORS:** unchanged — the API already returns permissive CORS, and Caddy passes it through. The PWA origin (GitHub Pages) is allowed via `CORS_ORIGIN` (default `*`).
- **Renewal:** Caddy's local CA root is long-lived (~10 years) and leaf certs auto-renew internally; no action needed. Keep the `./data/caddy` volume (it holds the CA — don't delete it, or you'll re-issue a new root and have to re-install on devices).
- **Reusable:** any future LAN service can sit behind this same Caddy (add a block to the `Caddyfile`) and your devices already trust the CA.
- **Auto mode (next):** with this HTTPS-local endpoint reachable, the planned PWA "Auto" toggle (probe Local → fall back to Remote) becomes viable — build that after verifying Local works here.
