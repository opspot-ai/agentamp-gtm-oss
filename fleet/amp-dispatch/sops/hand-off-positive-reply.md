# Hand off a positive reply

Queue the fixed calendar-link response for `amp-mailer`. Mark the lead booked only after Calendly sends an `invitee.created` event. Until then, the state is `reply-positive`, not `meeting-booked`.
