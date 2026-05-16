use rustfft::num_complex::Complex;
use rustfft::FftPlanner;

const SAMPLE_RATE: usize = 16_000;
const FRAME_SIZE: usize = 400; // 25ms
const HOP_SIZE: usize = 160; // 10ms
const N_FFT: usize = 512;

fn hz_to_mel(hz: f32) -> f32 {
    2595.0 * (1.0 + hz / 700.0).log10()
}

fn mel_to_hz(mel: f32) -> f32 {
    700.0 * (10f32.powf(mel / 2595.0) - 1.0)
}

fn hann_window(size: usize) -> Vec<f32> {
    (0..size)
        .map(|i| {
            0.5 - 0.5 * ((2.0 * std::f32::consts::PI * i as f32) / (size as f32 - 1.0)).cos()
        })
        .collect()
}

fn build_mel_filterbank(n_mels: usize) -> Vec<Vec<f32>> {
    let n_freqs = N_FFT / 2 + 1;
    let mel_min = hz_to_mel(0.0);
    let mel_max = hz_to_mel((SAMPLE_RATE / 2) as f32);

    let mel_points: Vec<f32> = (0..(n_mels + 2))
        .map(|i| mel_min + (i as f32) * (mel_max - mel_min) / ((n_mels + 1) as f32))
        .collect();

    let hz_points: Vec<f32> = mel_points.iter().map(|m| mel_to_hz(*m)).collect();
    let bins: Vec<usize> = hz_points
        .iter()
        .map(|hz| (((N_FFT + 1) as f32 * hz) / SAMPLE_RATE as f32) as usize)
        .collect();

    let mut filters = vec![vec![0.0f32; n_freqs]; n_mels];

    for mel_idx in 0..n_mels {
        let left = bins[mel_idx].min(n_freqs.saturating_sub(1));
        let center = bins[mel_idx + 1].min(n_freqs.saturating_sub(1));
        let right = bins[mel_idx + 2].min(n_freqs.saturating_sub(1));

        if left >= center || center >= right {
            continue;
        }

        for k in left..center {
            filters[mel_idx][k] = (k - left) as f32 / (center - left) as f32;
        }
        for k in center..right {
            filters[mel_idx][k] = (right - k) as f32 / (right - center) as f32;
        }
    }

    filters
}

pub fn extract_log_mel(samples_16k: &[f32], n_mels: usize) -> Vec<Vec<f32>> {
    if samples_16k.len() < FRAME_SIZE || n_mels == 0 {
        return Vec::new();
    }

    let window = hann_window(FRAME_SIZE);
    let mel_filters = build_mel_filterbank(n_mels);
    let mut planner = FftPlanner::new();
    let fft = planner.plan_fft_forward(N_FFT);

    let mut features: Vec<Vec<f32>> = Vec::new();
    let mut pos = 0usize;

    while pos + FRAME_SIZE <= samples_16k.len() {
        let mut frame: Vec<Complex<f32>> = vec![Complex::new(0.0, 0.0); N_FFT];
        for i in 0..FRAME_SIZE {
            frame[i].re = samples_16k[pos + i] * window[i];
        }

        fft.process(&mut frame);

        let power_spectrum: Vec<f32> = frame[..(N_FFT / 2 + 1)]
            .iter()
            .map(|c| (c.re * c.re) + (c.im * c.im))
            .collect();

        let mut mel_vec = vec![0.0f32; n_mels];
        for (m, filter) in mel_filters.iter().enumerate() {
            let energy = filter
                .iter()
                .zip(power_spectrum.iter())
                .map(|(f, p)| f * p)
                .sum::<f32>();
            mel_vec[m] = (energy.max(1e-10)).ln();
        }

        features.push(mel_vec);
        pos += HOP_SIZE;
    }

    features
}
