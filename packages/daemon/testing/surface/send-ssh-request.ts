type RequestCallback<Values extends readonly unknown[]> = (
  failure?: Readonly<Error> | null,
  ...values: Values
) => void;

export function sendSshRequest<Values extends readonly unknown[] = []>(
  send: (done: RequestCallback<Values>) => void,
): Promise<Values> {
  return new Promise((resolve, reject) => {
    send((failure, ...values) => {
      if (failure instanceof Error) {
        reject(failure);

        return;
      }

      resolve(values);
    });
  });
}
