import type { ReactNode } from "react";
import { BackLink } from "./BackLink";

interface ViewContainerProps {
  computerName: string;
  children: ReactNode;
}

export function ViewContainer({ computerName, children }: ViewContainerProps) {
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-gradient-to-br from-pink-200 via-purple-200 to-indigo-300 p-10">
      <div className="w-full max-w-4xl">
        <BackLink href={`/computer/${computerName}`} />
        {children}
      </div>
    </div>
  );
}
