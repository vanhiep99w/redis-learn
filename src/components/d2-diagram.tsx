'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { D2InteractiveDiagram, type D2InteractiveDiagramProps } from '@vanhiep99w/docs-kit/components/d2-interactive';

function ReadableFlow({ children }: { children: ReactNode }) {
  const frame = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    // A wide flow can begin in the middle of its SVG. Start mobile readers at
    // the entry node, not an empty left margin; never reset their later panning.
    const centerEntry = () => {
      const entry = [...element.querySelectorAll('.d2-viewer text')].find((node) => node.getBoundingClientRect().width > 0);
      if (!entry) return;
      const box = entry.getBoundingClientRect();
      element.scrollLeft += box.left - element.getBoundingClientRect().left - (element.clientWidth - box.width) / 2;
      observer.disconnect();
    };
    const observer = new MutationObserver(centerEntry);
    observer.observe(element, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
    centerEntry();
    return () => observer.disconnect();
  }, []);

  return <div className="d2-readable-flow" ref={frame}>{children}</div>;
}

/** Opt in in trusted D2 source with `# viewport: readable`. */
export function DocsD2Diagram(props: D2InteractiveDiagramProps) {
  const diagram = <D2InteractiveDiagram {...props} />;
  return /^# viewport: readable\s*$/m.test(props.source ?? '')
    ? <ReadableFlow>{diagram}</ReadableFlow>
    : diagram;
}
