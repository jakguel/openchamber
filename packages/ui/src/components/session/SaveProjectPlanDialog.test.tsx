import React from 'react';
import { afterAll, describe, expect, mock, spyOn, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import * as dialog from '@/components/ui/dialog';

type MockDialogProps = React.PropsWithChildren<{ open?: boolean; className?: string }>;

// De-mocked: the real Dialog primitives rely on DOM/portals that renderToStaticMarkup
// cannot resolve, so only those rendering-boundary components are spied with SSR-safe
// passthroughs before the subject is imported. The real SaveProjectPlanDialog renders.
spyOn(dialog, 'Dialog').mockImplementation(((({ children, open = true }: MockDialogProps) => (open ? <>{children}</> : null))) as unknown as typeof dialog.Dialog);
spyOn(dialog, 'DialogContent').mockImplementation(((({ children }: MockDialogProps) => <div>{children}</div>)) as unknown as typeof dialog.DialogContent);
spyOn(dialog, 'DialogDescription').mockImplementation(((({ children }: MockDialogProps) => <p>{children}</p>)) as unknown as typeof dialog.DialogDescription);
spyOn(dialog, 'DialogFooter').mockImplementation(((({ children }: MockDialogProps) => <div>{children}</div>)) as unknown as typeof dialog.DialogFooter);
spyOn(dialog, 'DialogHeader').mockImplementation(((({ children }: MockDialogProps) => <div>{children}</div>)) as unknown as typeof dialog.DialogHeader);
spyOn(dialog, 'DialogTitle').mockImplementation(((({ children }: MockDialogProps) => <h2>{children}</h2>)) as unknown as typeof dialog.DialogTitle);

const { SaveProjectPlanDialog } = await import('./SaveProjectPlanDialog');

afterAll(() => {
  mock.restore();
});

describe('SaveProjectPlanDialog', () => {
  test('associates the title label with the title input', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <SaveProjectPlanDialog
          open={true}
          onOpenChange={() => {}}
          initialTitle="Implementation plan"
          sourceText="Plan content"
          onSave={() => {}}
        />
      </I18nProvider>,
    );

    const labelMatch = markup.match(/<label[^>]*for="([^"]+)"[^>]*>/);
    if (!labelMatch) {
      throw new Error('Expected a label associated with the title input');
    }

    const [, titleInputId] = labelMatch;
    expect(markup).toContain(`id="${titleInputId}"`);
  });
});
