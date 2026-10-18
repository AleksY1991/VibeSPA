import type { TitlePolicy, TitlePolicyInputs } from '../contract';

export function createTitlePolicy(inputs: TitlePolicyInputs): TitlePolicy {
  if (!Number.isInteger(inputs.maximumLength) || inputs.maximumLength < 1) {
    throw new RangeError('Title policy maximumLength must be a positive integer.');
  }

  return {
    validate(value) {
      const title = value.trim().replace(/\s+/g, ' ');
      if (title.length === 0) {
        return { valid: false, message: 'Write one thing you want to focus on.' };
      }
      if (title.length > inputs.maximumLength) {
        return { valid: false, message: `Keep your intention within ${inputs.maximumLength} characters.` };
      }
      return { valid: true, title };
    },
  };
}
