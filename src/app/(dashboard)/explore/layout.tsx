import { Breadcrumb } from "@/components/explore/breadcrumb";
import { PeriodControl } from "@/components/explore/period-control";
import { lastNMonths } from "@/lib/rollup";

export default function ExploreLayout({ children }: { children: React.ReactNode }) {
  const months = [...lastNMonths(new Date(), 12)].reverse(); // newest first
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <Breadcrumb />
        <PeriodControl months={months} />
      </div>
      {children}
    </div>
  );
}
