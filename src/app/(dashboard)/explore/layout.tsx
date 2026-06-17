import { Breadcrumb } from "@/components/explore/breadcrumb";

export default function ExploreLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-6">
      <Breadcrumb />
      {children}
    </div>
  );
}
