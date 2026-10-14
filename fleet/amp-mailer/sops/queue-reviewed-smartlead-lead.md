# Queue a reviewed Smartlead lead

1. Require a qualified Clay record with a verified email and a source URL.
2. Require an `amp-reviewer` approval and a current production mail arm.
3. Respect product suppression and the configured initial daily cap.
4. Add the lead to the draft Smartlead campaign with the reviewed subject/body as custom fields.
5. Record the Smartlead lead ID and wait for a provider webhook before calling the message sent.

Never attach mailboxes or activate a campaign from this SOP.
