import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import styles from "../app/AppShell.module.css";

export type StyledSelectOption = {
  value: string;
  label: string;
};

type StyledSelectProps = {
  name?: string;
  ariaLabel?: string;
  value?: string;
  defaultValue?: string;
  options: StyledSelectOption[];
  onChange?: (value: string) => void;
};

type StyledMultiSelectProps = {
  name?: string;
  ariaLabel?: string;
  values?: string[];
  defaultValues?: string[];
  options: StyledSelectOption[];
  onChange?: (values: string[]) => void;
};

export function StyledSelect({ name, ariaLabel, value, defaultValue, options, onChange }: StyledSelectProps) {
  const id = useId();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const handledMouseDownRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [internalValue, setInternalValue] = useState(defaultValue ?? options[0]?.value ?? "");
  const selectedValue = value ?? internalValue;
  const selectedLabel = options.find((option) => option.value === selectedValue)?.label ?? selectedValue;

  useEffect(() => {
    const closeOtherSelect = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== id) {
        setOpen(false);
      }
    };
    window.addEventListener("paintopia:styled-select-open", closeOtherSelect);
    return () => window.removeEventListener("paintopia:styled-select-open", closeOtherSelect);
  }, [id]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  function selectValue(nextValue: string) {
    setInternalValue(nextValue);
    onChange?.(nextValue);
    setOpen(false);
  }

  function handleButtonPress() {
    setOpen((current) => {
      const nextOpen = !current;
      if (nextOpen) {
        window.dispatchEvent(new CustomEvent("paintopia:styled-select-open", { detail: id }));
      }
      return nextOpen;
    });
  }

  function handleButtonClick() {
    if (handledMouseDownRef.current) {
      handledMouseDownRef.current = false;
      return;
    }
    handleButtonPress();
  }

  function handleOptionClick(nextValue: string) {
    if (handledMouseDownRef.current) {
      handledMouseDownRef.current = false;
      return;
    }
    selectValue(nextValue);
  }

  return (
    <div className={styles.styledSelect} ref={wrapperRef}>
      <select
        className={styles.nativeSelectMirror}
        id={id}
        name={name}
        aria-label={ariaLabel}
        value={selectedValue}
        onChange={(event) => selectValue(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
      <button
        type="button"
        className={styles.styledSelectButton}
        aria-haspopup="listbox"
        aria-expanded={open ? "true" : "false"}
        title={selectedLabel}
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          handledMouseDownRef.current = true;
          handleButtonPress();
        }}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          handleButtonClick();
        }}
      >
        <span>{selectedLabel}</span>
        <ChevronDown className={open ? styles.styledSelectIconOpen : styles.styledSelectIcon} size={16} strokeWidth={2.2} aria-hidden="true" />
      </button>
      {open ? (
        <div className={styles.styledSelectMenu} role="listbox" aria-label={ariaLabel}>
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              className={option.value === selectedValue ? styles.styledSelectOptionActive : styles.styledSelectOption}
              role="option"
              aria-selected={option.value === selectedValue ? "true" : "false"}
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                handledMouseDownRef.current = true;
                selectValue(option.value);
              }}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                handleOptionClick(option.value);
              }}
            >
              <span title={option.label}>{option.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
export function StyledMultiSelect({ name, ariaLabel, values, defaultValues, options, onChange }: StyledMultiSelectProps) {
  const id = useId();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const handledMouseDownRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [internalValues, setInternalValues] = useState<string[]>(defaultValues ?? []);
  const selectedValues = values ?? internalValues;
  const selectedLabels = selectedValues.map((selectedValue) => (
    options.find((option) => option.value === selectedValue)?.label ?? selectedValue
  ));
  const selectedLabel = selectedLabels.length === 0
    ? "未选择"
    : selectedLabels.length <= 2
      ? selectedLabels.join(", ")
      : `${selectedLabels.slice(0, 2).join(", ")} +${selectedLabels.length - 2}`;

  useEffect(() => {
    const closeOtherSelect = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== id) {
        setOpen(false);
      }
    };
    window.addEventListener("paintopia:styled-select-open", closeOtherSelect);
    return () => window.removeEventListener("paintopia:styled-select-open", closeOtherSelect);
  }, [id]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  function applyValues(nextValues: string[]) {
    const dedupedValues = Array.from(new Set(nextValues.filter(Boolean)));
    setInternalValues(dedupedValues);
    onChange?.(dedupedValues);
  }

  function toggleValue(nextValue: string) {
    applyValues(
      selectedValues.includes(nextValue)
        ? selectedValues.filter((item) => item !== nextValue)
        : [...selectedValues, nextValue]
    );
  }

  function handleButtonPress() {
    setOpen((current) => {
      const nextOpen = !current;
      if (nextOpen) {
        window.dispatchEvent(new CustomEvent("paintopia:styled-select-open", { detail: id }));
      }
      return nextOpen;
    });
  }

  function handleButtonClick() {
    if (handledMouseDownRef.current) {
      handledMouseDownRef.current = false;
      return;
    }
    handleButtonPress();
  }

  function handleOptionClick(nextValue: string) {
    if (handledMouseDownRef.current) {
      handledMouseDownRef.current = false;
      return;
    }
    toggleValue(nextValue);
  }

  return (
    <div className={styles.styledSelect} ref={wrapperRef}>
      <select
        className={styles.nativeSelectMirror}
        id={id}
        name={name}
        aria-label={ariaLabel}
        multiple
        value={selectedValues}
        onChange={(event) => applyValues(Array.from(event.target.selectedOptions, (option) => option.value))}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
      <button
        type="button"
        className={styles.styledSelectButton}
        aria-haspopup="listbox"
        aria-expanded={open ? "true" : "false"}
        title={selectedLabels.join(", ")}
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          handledMouseDownRef.current = true;
          handleButtonPress();
        }}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          handleButtonClick();
        }}
      >
        <span>{selectedLabel}</span>
        <ChevronDown className={open ? styles.styledSelectIconOpen : styles.styledSelectIcon} size={16} strokeWidth={2.2} aria-hidden="true" />
      </button>
      {open ? (
        <div className={styles.styledSelectMenu} role="listbox" aria-label={ariaLabel} aria-multiselectable="true">
          {options.map((option) => {
            const selected = selectedValues.includes(option.value);
            return (
              <button
                key={option.value}
                type="button"
                className={selected ? styles.styledSelectOptionActive : styles.styledSelectOption}
                role="option"
                aria-selected={selected ? "true" : "false"}
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  handledMouseDownRef.current = true;
                  toggleValue(option.value);
                }}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  handleOptionClick(option.value);
                }}
              >
                <span title={option.label}>{option.label}</span>
                <Check className={styles.styledSelectOptionCheck} size={15} strokeWidth={2.4} aria-hidden="true" data-visible={selected ? "true" : "false"} />
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
