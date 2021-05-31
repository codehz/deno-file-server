export class ErrorWithStatusCode extends Error {
  code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export class RangeNotSatisfiable extends ErrorWithStatusCode {
  constructor(additional: string) {
    super(416, `Range Not Satisfiable: ${additional}`);
  }
}
