import './ErrorMessage.css';

interface ErrorMessageProps {
  message: string;
  onDismiss: () => void;
}

export function ErrorMessage({ message, onDismiss }: ErrorMessageProps) {
  return (
    <div className="error-message">
      <span className="error-message__text">{message}</span>
      <button className="error-message__dismiss" onClick={onDismiss}>
        &times;
      </button>
    </div>
  );
}
