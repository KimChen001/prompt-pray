import { Suspense } from "react";
import { NewReading } from "./NewReading";

export default function NewReadingPage() {
  return (
    <Suspense fallback={null}>
      <NewReading />
    </Suspense>
  );
}
