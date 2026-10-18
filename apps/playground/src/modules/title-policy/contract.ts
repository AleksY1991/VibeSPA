export type TitleValidation =
  | { readonly valid: true; readonly title: string }
  | { readonly valid: false; readonly message: string };

export interface TitlePolicy {
  validate(title: string): TitleValidation;
}

export interface TitlePolicyInputs {
  readonly maximumLength: number;
}
