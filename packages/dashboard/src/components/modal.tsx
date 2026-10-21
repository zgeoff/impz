import { Dialog } from '@ark-ui/react/dialog';
import { Portal } from '@ark-ui/react/portal';
import type { ReactNode } from 'react';
import styles from './modal.module.css';

interface ModalProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description?: string;
  readonly children: ReactNode;
}

export function Modal(props: ModalProps) {
  return (
    <Dialog.Root
      open={props.open}
      onOpenChange={(details) => {
        props.onOpenChange(details.open);
      }}
      lazyMount
      unmountOnExit
    >
      <Portal>
        <Dialog.Backdrop className={styles['backdrop']} />
        <Dialog.Positioner className={styles['positioner']}>
          <Dialog.Content className={styles['content']}>
            <Dialog.Title className={styles['title']}>{props.title}</Dialog.Title>
            {props.description !== undefined && (
              <Dialog.Description className={styles['description']}>
                {props.description}
              </Dialog.Description>
            )}
            {props.children}
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
