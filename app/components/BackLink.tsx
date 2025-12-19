interface BackLinkProps {
  href: string;
}

export function BackLink({ href }: BackLinkProps) {
  return (
    <a
      href={href}
      className="inline-block mb-2 text-purple-900 hover:text-purple-700 underline text-sm font-medium"
    >
      &lt; back
    </a>
  );
}
