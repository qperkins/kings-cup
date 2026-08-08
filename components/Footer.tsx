import { Coffee, ExternalLink, Code2 } from "lucide-react";

export function Footer() {
  return (
    <footer className="w-full border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container flex flex-col items-center justify-center gap-4 py-6 md:h-16 md:flex-row md:py-0">
        <div className="flex flex-col gap-4 text-center text-sm leading-loose text-muted-foreground md:flex-row md:gap-6">
          <a
            href="https://github.com/qperkins/kings-cup"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 transition-colors hover:text-foreground"
          >
            <Code2 className="h-4 w-4" />
            View Code
          </a>
          <div className="hidden md:block text-muted-foreground/40">•</div>
          <a
            href="https://buymeacoffee.com/qperkins"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 font-medium transition-colors hover:text-foreground"
          >
            <Coffee className="h-4 w-4" />
            Buy me a coffee
          </a>
          <div className="hidden md:block text-muted-foreground/40">•</div>
          <a
            href="https://www.blackivorywd.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 transition-colors hover:text-foreground"
          >
            Made by Elias Perkins
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </div>
    </footer>
  );
}
