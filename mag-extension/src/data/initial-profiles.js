(function initializeProfiles(root) {
  "use strict";
  const MAG = (root.MAG = root.MAG || {});

  MAG.INITIAL_PROFILES = Object.freeze([
    {
      id: "magical-dream-builders",
      label: "Magical Dream Builders",
      scope: "INTERNAL",
      kind: "ORGANIZATION",
      organization: {
        publicName: "Magical Dream Builders",
        shortName: "Magical Dream Builders",
        businessType: "Nonprofit organization"
      },
      content: {
        organizationDescription: {
          short: "Magical Dream Builders is a nonprofit organization.",
          medium: "Magical Dream Builders is a nonprofit organization that presents the annual Operation Winter Wonderland community event."
        },
        nonprofitBoilerplate: "Magical Dream Builders is a nonprofit organization."
      },
      linkedProfileIds: ["christmas-at-the-magical-midway-2026"]
    },
    {
      id: "christmas-at-the-magical-midway-2026",
      label: "Christmas At The Magical Midway (2026)",
      scope: "INTERNAL",
      kind: "EVENT",
      organization: {
        publicName: "Magical Dream Builders",
        businessType: "Nonprofit organization"
      },
      event: {
        name: "Christmas At The Magical Midway",
        seriesName: "Operation Winter Wonderland",
        organizer: "Magical Dream Builders",
        date: "2026-12-12",
        startTime: "12:00",
        endTime: "16:00",
        venue: "Richardson Community Center",
        city: "Lake City",
        state: "Florida",
        audience: "Community",
        annualContext: "Annual signature event",
        sponsorshipInformation: "Community partners may host free activity stations, donate toys, donate or sponsor bikes, or support in multiple ways."
      },
      content: {
        eventDescription: {
          short: "Christmas At The Magical Midway is Magical Dream Builders’ 2026 Operation Winter Wonderland event in Lake City, Florida.",
          medium: "Christmas At The Magical Midway, Magical Dream Builders’ 2026 Operation Winter Wonderland event, will take place Saturday, December 12, 2026, from 12 PM–4 PM at Richardson Community Center in Lake City, Florida. The goal is 100 bikes.",
          long: "Christmas At The Magical Midway, Magical Dream Builders’ 2026 Operation Winter Wonderland event, will take place Saturday, December 12, 2026, from 12 PM–4 PM at Richardson Community Center in Lake City, Florida. The goal is 100 bikes. Community partners may host free activity stations, donate toys, donate or sponsor bikes, or support the event in multiple ways."
        },
        organizationDescription: {
          short: "Magical Dream Builders is a nonprofit organization."
        },
        approvedCta: "Community partners may host a free activity station, donate toys, donate or sponsor bikes, or support in multiple ways."
      },
      safeguards: {
        excludedClaims: ["3rd Annual"],
        electronicDonationsActive: false
      },
      linkedProfileIds: ["magical-dream-builders"]
    },
    {
      id: "altaire-financial-group",
      label: "Altaire Financial Group",
      scope: "INTERNAL",
      kind: "ORGANIZATION",
      organization: {
        publicName: "Altaire Financial Group",
        shortName: "Altaire Financial Group",
        website: "https://www.altairefinancial.com/",
        email: "dandre.combs@altairefinancial.com",
        phone: "(386) 344-0302",
        serviceLanes: ["Tax Preparation", "Credit Restoration/Repair", "Funding", "Bookkeeping & Payroll", "Business Services", "Marketing & Design", "Notary"]
      },
      content: {
        organizationDescription: {
          short: "Altaire Financial Group provides tax preparation, credit restoration and repair, funding, bookkeeping and payroll, business services, marketing and design, and notary services."
        }
      }
    },
    {
      id: "dandre-d-combs-jr",
      label: "D’Andre D. Combs Jr. / Dre",
      scope: "INTERNAL",
      kind: "PERSON",
      person: {
        fullName: "D’Andre D. Combs Jr.",
        preferredName: "Dre",
        firstName: "D’Andre",
        lastName: "D. Combs Jr."
      },
      content: {}
    },
    {
      id: "ice-house-jewelers",
      label: "Ice House Jewelers",
      scope: "INTERNAL",
      kind: "ORGANIZATION",
      organization: {
        publicName: "Ice House Jewelers",
        shortName: "Ice House Jewelers",
        businessType: "Jewelry business"
      },
      content: {
        organizationDescription: {
          short: "Ice House Jewelers is an active jewelry business."
        }
      },
      notes: ["Website/store is being completed.", "Do not create manual quote or CRM flows."]
    },
    {
      id: "dollar-district",
      label: "K.N. Roberts House / Dollar District",
      scope: "INTERNAL",
      kind: "PRODUCT",
      organization: {
        publicName: "K.N. Roberts House",
        shortName: "KNR House",
        businessType: "Publishing imprint"
      },
      product: {
        name: "Dollar District",
        category: "Children’s financial workbook",
        stage: "Production/manufacturing"
      },
      content: {
        organizationDescription: {
          short: "K.N. Roberts House is the publishing imprint for Dollar District."
        },
        productDescription: {
          short: "Dollar District is a children’s financial workbook currently in production and manufacturing."
        }
      }
    }
  ]);
})(globalThis);
