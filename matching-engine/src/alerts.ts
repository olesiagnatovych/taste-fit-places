// Quota-alert stub for the public showcase. In the private build this module sends one email
// (via Resend) when month-to-date spend reaches the current threshold. Here it only logs, so the
// repo carries no email provider, no addresses and no extra API key. The function name and the
// fail-visible contract are unchanged, so the handlers and the verify-* scripts work as they do
// in the private build: a failed alert still throws, and the caller still fails closed (denies
// the search that crossed the threshold).

export interface QuotaAlertDetails {
  currentMonthSpendUsd: number;
  thresholdUsd: number;
  searchCountThisMonth: number;
}

export async function sendQuotaAlertEmail(details: QuotaAlertDetails): Promise<void> {
  console.warn(
    [
      `Quota alert: month-to-date spend has reached the current threshold.`,
      `  Current spend: $${details.currentMonthSpendUsd.toFixed(2)}`,
      `  Threshold: $${details.thresholdUsd}`,
      `  Searches this month: ${details.searchCountThisMonth}`,
      `  New searches are denied until the threshold is raised.`,
    ].join("\n"),
  );
}
