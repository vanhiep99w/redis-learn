'use client';

import { useEffect, useId, useRef } from 'react';

export function MermaidDiagram({ chart }: { chart: string }) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const safeId = `mermaid-${id.replace(/:/g, '')}`;

  useEffect(() => {
    if (!ref.current) return;
    let cancelled = false;

    import('mermaid').then((m) => {
      if (cancelled) return;
      m.default.initialize({ startOnLoad: false });
      m.default.render(safeId, chart).then(({ svg }) => {
        if (!cancelled && ref.current) {
          ref.current.innerHTML = svg;
        }
      });
    });

    return () => {
      cancelled = true;
    };
  }, [chart, safeId]);

  return (
    <div
      ref={ref}
      className="my-6 flex justify-center overflow-x-auto"
    />
  );
}
