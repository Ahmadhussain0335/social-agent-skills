# Platform setup guides

Each guide explains how to create your own developer app, which permissions to grant,
where to put the credentials, review or audit steps, and the limits that matter. The same
text is copied into each skill's `references/setup.md` at build time.

| Platform | Guide | Credentials | Review needed for your own account |
| - | - | - | - |
| YouTube | [youtube-setup.md](youtube-setup.md) | Google Desktop OAuth client, API key | No (quota increases need an audit) |
| Facebook, Instagram, Threads | [meta-setup.md](meta-setup.md) | Meta app ID/secret, Threads app ID/secret | No (Standard Access) |
| WhatsApp | [whatsapp-setup.md](whatsapp-setup.md) | System User token, phone number and WABA IDs | No; business verification raises limits |
| X | [x-setup.md](x-setup.md) | Native App client ID | No; pay-per-use credits required |
| LinkedIn | [linkedin-setup.md](linkedin-setup.md) | App client ID/secret | No for personal profile; yes for company pages |
| Pinterest | [pinterest-setup.md](pinterest-setup.md) | App ID/secret | Standard access (demo video) for public Pins |
| TikTok | [tiktok-setup.md](tiktok-setup.md) | Client key/secret | Audit not available to personal apps: drafts or private posts |
| Telegram | [telegram-setup.md](telegram-setup.md) | Bot token, channel ID | No |
| Discord | [discord-setup.md](discord-setup.md) | Channel webhook URL | No |
| Bluesky | [bluesky-setup.md](bluesky-setup.md) | Handle, app password | No |
| Mastodon | [mastodon-setup.md](mastodon-setup.md) | Instance URL, access token | No |
| Google Business Profile | [google-business-setup.md](google-business-setup.md) | Google Desktop OAuth client | Yes: API access application |
| Reddit | [reddit-setup.md](reddit-setup.md) | None (draft only) | Not applicable |
