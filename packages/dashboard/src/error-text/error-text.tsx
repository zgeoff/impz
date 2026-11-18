import styles from './error-text.module.css';

interface ErrorTextProps {
  readonly error: Error | null;
}

export function ErrorText(props: ErrorTextProps) {
  if (props.error === null) {
    return null;
  }

  return (
    <p className={styles['error']} role="alert">
      {props.error.message}
    </p>
  );
}
