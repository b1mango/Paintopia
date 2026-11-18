import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Check, ChevronDown } from "lucide-react";
import styles from "./StyledSelect.module.css";

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

function notifyContainerDirty(wrapper: HTMLDivElement | null) {
  wrapper?.dispatchEvent(new Event("input", { bubbles: true }));
}

export function StyledSelect({ name, ariaLabel, value, defaultValue, options, onChange }: StyledSelectProps) {
  const id = useId();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
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
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", onEscape, true);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", onEscape, true);
    };
  }, [open]);

  function openMenuAndFocus(index?: number) {
    if (!options.length) return;
    window.dispatchEvent(new CustomEvent("paintopia:styled-select-open", { detail: id }));
    setOpen(true);
    if (index !== undefined) {
      const clamped = Math.max(0, Math.min(options.length - 1, index));
      requestAnimationFrame(() => optionRefs.current[clamped]?.focus());
    }
  }

  function selectValue(nextValue: string, fromUserUI = false) {
    const changed = nextValue !== selectedValue;
    setInternalValue(nextValue);
    onChange?.(nextValue);
    if (fromUserUI && changed) notifyContainerDirty(wrapperRef.current);
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
    selectValue(nextValue, true);
  }

  function handleTriggerKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (!options.length) return;
    const activeIndex = Math.max(0, options.findIndex((option) => option.value === selectedValue));
    if (event.key === "ArrowDown") {
      event.preventDefault();
      openMenuAndFocus(open ? Math.min(options.length - 1, activeIndex + 1) : activeIndex);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      openMenuAndFocus(open ? Math.max(0, activeIndex - 1) : activeIndex);
    } else if (event.key === "Home" && open) {
      event.preventDefault();
      openMenuAndFocus(0);
    } else if (event.key === "End" && open) {
      event.preventDefault();
      openMenuAndFocus(options.length - 1);
    }
  }

  function handleOptionKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number, optionValue: string) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      optionRefs.current[(index + 1) % options.length]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      optionRefs.current[(index - 1 + options.length) % options.length]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      optionRefs.current[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      optionRefs.current[options.length - 1]?.focus();
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectValue(optionValue, true);
      buttonRef.current?.focus();
    }
  }

  return (
    <div className={styles.styledSelect} ref={wrapperRef}>
      <select
        className={styles.nativeSelectMirror}
        id={id}
        name={name}
        tabIndex={-1}
        aria-label={ariaLabel}
        value={selectedValue}
        onChange={(event) => selectValue(event.target.value, false)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
      <button
        ref={buttonRef}
        type="button"
        className={styles.styledSelectButton}
        aria-haspopup="listbox"
        aria-expanded={open ? "true" : "false"}
        title={selectedLabel}
        onKeyDown={handleTriggerKeyDown}
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
        <ChevronDown className={open ? styles.styledSelectIconOpen : styles.styledSelectIcon} size={16} strokeWidth={1.6} aria-hidden="true" />
      </button>
      {open ? (
        <div className={styles.styledSelectMenu} role="listbox" aria-label={ariaLabel}>
          {options.map((option, index) => (
            <button
              ref={(node) => { optionRefs.current[index] = node; }}
              key={option.value}
              type="button"
              className={option.value === selectedValue ? styles.styledSelectOptionActive : styles.styledSelectOption}
              role="option"
              aria-selected={option.value === selectedValue ? "true" : "false"}
              onKeyDown={(event) => handleOptionKeyDown(event, index, option.value)}
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                handledMouseDownRef.current = true;
                selectValue(option.value, true);
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
  const buttonRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
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
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", onEscape, true);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", onEscape, true);
    };
  }, [open]);

  function openMenuAndFocus(index?: number) {
    if (!options.length) return;
    window.dispatchEvent(new CustomEvent("paintopia:styled-select-open", { detail: id }));
    setOpen(true);
    if (index !== undefined) {
      const clamped = Math.max(0, Math.min(options.length - 1, index));
      requestAnimationFrame(() => optionRefs.current[clamped]?.focus());
    }
  }

  function applyValues(nextValues: string[], fromUserUI = false) {
    const dedupedValues = Array.from(new Set(nextValues.filter(Boolean)));
    setInternalValues(dedupedValues);
    onChange?.(dedupedValues);
    if (fromUserUI) notifyContainerDirty(wrapperRef.current);
  }

  function toggleValue(nextValue: string, fromUserUI = false) {
    applyValues(
      selectedValues.includes(nextValue)
        ? selectedValues.filter((item) => item !== nextValue)
        : [...selectedValues, nextValue],
      fromUserUI
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
    toggleValue(nextValue, true);
  }

  function handleTriggerKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (!options.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      openMenuAndFocus(0);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      openMenuAndFocus(options.length - 1);
    } else if (event.key === "Home" && open) {
      event.preventDefault();
      openMenuAndFocus(0);
    } else if (event.key === "End" && open) {
      event.preventDefault();
      openMenuAndFocus(options.length - 1);
    }
  }

  function handleOptionKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number, optionValue: string) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      optionRefs.current[(index + 1) % options.length]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      optionRefs.current[(index - 1 + options.length) % options.length]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      optionRefs.current[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      optionRefs.current[options.length - 1]?.focus();
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggleValue(optionValue, true);
    }
  }

  return (
    <div className={styles.styledSelect} ref={wrapperRef}>
      <select
        className={styles.nativeSelectMirror}
        id={id}
        name={name}
        tabIndex={-1}
        aria-label={ariaLabel}
        multiple
        value={selectedValues}
        onChange={(event) => applyValues(Array.from(event.target.selectedOptions, (option) => option.value), false)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
      <button
        ref={buttonRef}
        type="button"
        className={styles.styledSelectButton}
        aria-haspopup="listbox"
        aria-expanded={open ? "true" : "false"}
        title={selectedLabels.join(", ")}
        onKeyDown={handleTriggerKeyDown}
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
        <ChevronDown className={open ? styles.styledSelectIconOpen : styles.styledSelectIcon} size={16} strokeWidth={1.6} aria-hidden="true" />
      </button>
      {open ? (
        <div className={styles.styledSelectMenu} role="listbox" aria-label={ariaLabel} aria-multiselectable="true">
          {options.map((option, index) => {
            const selected = selectedValues.includes(option.value);
            return (
              <button
                ref={(node) => { optionRefs.current[index] = node; }}
                key={option.value}
                type="button"
                className={selected ? styles.styledSelectOptionActive : styles.styledSelectOption}
                role="option"
                aria-selected={selected ? "true" : "false"}
                onKeyDown={(event) => handleOptionKeyDown(event, index, option.value)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  handledMouseDownRef.current = true;
                  toggleValue(option.value, true);
                }}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  handleOptionClick(option.value);
                }}
              >
                <span title={option.label}>{option.label}</span>
                <Check className={styles.styledSelectOptionCheck} size={15} strokeWidth={2} aria-hidden="true" data-visible={selected ? "true" : "false"} />
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
