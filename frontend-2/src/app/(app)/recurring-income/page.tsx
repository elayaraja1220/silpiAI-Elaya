import { RecurringIncomeCard } from "@/components/business/recurring-income-card";

/** Recurring income: administrators only. The studio (this page included) is behind the administrator sign-in, and its API checks the administrator again. */
export default function Page() {
  return (
    <div className="space-y-5">
      <RecurringIncomeCard />
    </div>
  );
}
