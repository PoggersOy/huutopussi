import { ILLISOFT_RULES, type RuleConfig } from '@hp/engine';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../src/i18n';
import { RuleConfigEditor } from '../src/rules';

beforeEach(async () => {
  await i18n.changeLanguage('en');
});

afterEach(cleanup);

describe('RuleConfigEditor', () => {
  it('edits every formerly missing engine variation', () => {
    const onChange = vi.fn<(next: RuleConfig) => void>();
    render(<RuleConfigEditor value={ILLISOFT_RULES} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText('Bid increment'), { target: { value: '10' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...ILLISOFT_RULES, bidStep: 10 });

    fireEvent.change(screen.getByLabelText('First to bid'), { target: { value: 'dealer' } });
    expect(onChange).toHaveBeenLastCalledWith({
      ...ILLISOFT_RULES,
      firstBidder: 'dealer',
    });

    fireEvent.click(screen.getByLabelText(/Must hold the asked half/));
    expect(onChange).toHaveBeenLastCalledWith({
      ...ILLISOFT_RULES,
      askHalfMustHoldCard: false,
    });
  });
});
