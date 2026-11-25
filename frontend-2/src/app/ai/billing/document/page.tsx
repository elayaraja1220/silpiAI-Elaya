import { Suspense } from "react";

import { TaxDocumentPage } from "@/components/ai/tax-document";

export default function Page() {
  return (
    <Suspense fallback={null}>
      <TaxDocumentPage />
    </Suspense>
  );
}
