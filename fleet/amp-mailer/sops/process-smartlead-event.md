# Process a Smartlead event

Deduplicate the provider event before changing state. Sent events close the delivery receipt; bounces suppress the address; opt-outs suppress immediately; positive replies queue the calendar-link handoff. Never infer a booked meeting from a reply—only a Calendly `invitee.created` event earns that receipt.
