// The Performance report's points (the rule chosen on 26 Nov 2026): what each activity scores. The dashboard counts
// with the same table (client/lib/performance.ts POINTS), so a change here needs the same change there.
//   a phone number found  1.5
//   an email found        1
//   a CV shared           5, to whoever found the number or email it was shared on (not to the caller), on the day
//                         the CV was shared, once per student's call (api/routes.js cvSharedEvents)
export const POINTS = { phone: 1.5, email: 1, cvShared: 5 };

export const pointsOf = ({ phones = 0, emails = 0, cvShared = 0 }) => phones * POINTS.phone + emails * POINTS.email + cvShared * POINTS.cvShared;
