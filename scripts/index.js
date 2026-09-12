
const STEPS = [
  "step-organization",
  "step-project",
  "step-narrative",
  "step-budget",
  "step-notes",
];

const STEP_LABELS = [
  "Organization",
  "Project",
  "Narrative",
  "Budget",
  "Additional Notes",
];

let currentStep = 0;



function showStep(index) {
  STEPS.forEach((id, i) => {
    const el = document.getElementById(id);

    if (el) {
      el.hidden = i !== index;
    }
  });

  // Hide Back button on first step
  document.getElementById("backBtn").hidden = index === 0;

  // Hide Next button on last step
  document.getElementById("nextBtn").hidden =
    index === STEPS.length - 1;

  // Show Generate PDF button on last step
  document.getElementById("generateBtn").hidden =
    index !== STEPS.length - 1;

  // Update step label
  document.getElementById("stepLabel").textContent =
    `Step ${index + 1} of ${STEPS.length}: ${STEP_LABELS[index]}`;

  currentStep = index;
}


// ---------------------------------------------------------------
// Next button
// ---------------------------------------------------------------

function nextStep() {
  if (currentStep < STEPS.length - 1) {
    showStep(currentStep + 1);
  }
}


// ---------------------------------------------------------------
// Back button
// ---------------------------------------------------------------

function prevStep() {
  if (currentStep > 0) {
    showStep(currentStep - 1);
  }
}


// ---------------------------------------------------------------
// Initialize wizard
// ---------------------------------------------------------------

showStep(0);

